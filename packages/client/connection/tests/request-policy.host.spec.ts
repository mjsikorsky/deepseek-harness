/** Native request authority covers raw routes and their complete byte lifetimes. */
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'
import type { ConnectionRequestLease, ConnectionRequestPolicy } from '../src/index.ts'
import { dispatchWithRequestPolicy } from '../src/request-policy.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

function fixture() {
  const revocation = new AbortController()
  const released = vi.fn()
  const lease: ConnectionRequestLease = {
    signal: revocation.signal,
    async run(dispatch) { revocation.signal.throwIfAborted(); return dispatch() },
    release: released,
  }
  const policy: ConnectionRequestPolicy = { async admit() { return lease } }
  const owner = new AbortController()
  const completions: Promise<void>[] = []
  const run = (request: Request, dispatch: (request: Request) => Promise<Response>, selected = policy) =>
    dispatchWithRequestPolicy(request, selected, true, owner.signal, done => completions.push(done), dispatch)
  return { revocation, released, lease, policy, owner, completions, run }
}

describe('native request authority lifetime', () => {
  it.each(['missing', 'denied', 'throws'] as const)('cancels denied input with %s provider before native dispatch', async (kind) => {
    const cancel = vi.fn(() => { throw new Error('source cancellation failed') })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const request = new Request('http://dsh.internal/api/upload', { method: 'POST', body, duplex: 'half' } as RequestInit)
    const dispatch = vi.fn()
    const policy = kind === 'missing' ? undefined : {
      async admit() { if (kind === 'throws') throw new Error('denied'); return undefined },
    }
    const response = await dispatchWithRequestPolicy(request, policy, true, new AbortController().signal, () => {}, dispatch)
    expect(response.status).toBe(403)
    expect(dispatch).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('releases on owner disposal even when native dispatch never settles and input cancellation throws', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>()
    const cancel = vi.fn(() => { throw new Error('broken source') })
    const body = new ReadableStream<Uint8Array>({ cancel })
    const result = f.run(new Request('http://dsh.internal/api/upload', { method: 'POST', body, duplex: 'half' } as RequestInit), async () => {
      entered.resolve(undefined)
      return new Promise<Response>(() => {})
    })
    await entered.promise
    f.owner.abort(new Error('owner disposed'))
    expect((await result).status).toBe(403)
    await Promise.all(f.completions)
    expect(f.released).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves a native handler exception when release aborts the lease signal', async () => {
    const f = fixture()
    f.lease.release = () => { f.released(); f.revocation.abort(new Error('released')) }
    const failure = new Error('native handler failed')
    await expect(f.run(new Request('http://dsh.internal/api/file'), async () => { throw failure })).rejects.toBe(failure)
    expect(f.released).toHaveBeenCalledOnce()
  })

  it('cancels a response that arrives after authority was revoked', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<Response>()
    const result = f.run(new Request('http://dsh.internal/api/file'), async () => { entered.resolve(undefined); return late.promise })
    await entered.promise
    f.revocation.abort(new Error('expired'))
    expect((await result).status).toBe(403)
    const cancelled = Promise.withResolvers<undefined>()
    late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(undefined) } })))
    await cancelled.promise
    expect(f.released).toHaveBeenCalledOnce()
  })

  it('does not wait for a denied admission and releases a late admitted lease', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<ConnectionRequestLease>()
    const entered = Promise.withResolvers<undefined>()
    const result = f.run(new Request('http://dsh.internal/api/file'), vi.fn(), {
      async admit() { entered.resolve(undefined); return pending.promise },
    })
    await entered.promise
    f.owner.abort(new Error('owner disposed'))
    expect((await result).status).toBe(403)
    pending.resolve(f.lease)
    await pending.promise
    await Promise.resolve(undefined)
    expect(f.released).toHaveBeenCalledOnce()
  })

  it('retains the lease through actual response pulls and cancels a stalled source on revocation', async () => {
    const f = fixture()
    const pulling = Promise.withResolvers<undefined>()
    const cancel = vi.fn()
    let first = true
    const response = await f.run(new Request('http://dsh.internal/api/file'), async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) { first = false; controller.enqueue(new TextEncoder().encode('first')) }
        else { pulling.resolve(undefined); return new Promise<void>(() => {}) }
      }, cancel,
    }, { highWaterMark: 0 }), { headers: { 'x-original': 'native' } }))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    expect(f.released).not.toHaveBeenCalled()
    const next = reader.read()
    await pulling.promise
    f.revocation.abort(new Error('revoked'))
    await expect(next).rejects.toThrow('revoked')
    await Promise.all(f.completions)
    expect(cancel).toHaveBeenCalledOnce()
    expect(f.released).toHaveBeenCalledOnce()
    expect(response.headers.get('x-original')).toBe('native')
  })

  it('enforces raw file ownership through the real HTTP listener and preserves authorized bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-request-policy-'))
    const path = join(directory, 'report.bin')
    const bytes = Buffer.from([0, 4, 255, 7, 32])
    await writeFile(path, bytes)
    const ctx = new Context()
    const released = vi.fn()
    const opened = vi.fn()
    provideBrowserCredentials(ctx)
    ctx.provide('connectionRequestPolicy', {
      async admit(request) {
        if (request.headers['x-fixture-workspace'] !== 'workspace-a') return undefined
        return { signal: request.signal, async run(dispatch) { return dispatch() }, release: released }
      },
    })
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
      await ctx.plugin(Connection, { requireRequestPolicy: true }).await()
      ctx.connection.fetch.register({ path: '/api/file', methods: ['GET'], requestBody: 'buffered', async fetch() {
        opened()
        return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, {
          headers: { 'content-type': 'application/octet-stream', 'x-native-file': 'yes' },
        })
      } })
      const rpc = vi.fn(async (_endpoint: string, payload: unknown) => ({ ok: true as const, value: payload }))
      ctx.connection.rpc.handle('/rpc', rpc)
      ctx.connection.rpc.intercept('/api', endpoint => endpoint === 'echo', rpc)
      const origin = `http://127.0.0.1:${ctx.webServer.port}`
      const auth = new URL(ctx.connection.authenticatedUrl(origin))
      let cookie = ''
      ctx.connection.authorizeIndex({ method: 'GET', url: auth.pathname + auth.search, headers: { host: auth.host } }, {
        writeHead(_status: number, headers: Record<string, string>) { cookie = headers['set-cookie']!.split(';')[0]! }, end() {},
      })
      const denied = await fetch(`${origin}/api/file`, { headers: { cookie, 'x-fixture-workspace': 'workspace-b' } })
      expect(denied.status).toBe(403)
      await denied.text()
      expect(opened).not.toHaveBeenCalled()
      const allowed = await fetch(`${origin}/api/file`, { headers: { cookie, 'x-fixture-workspace': 'workspace-a' } })
      expect(allowed.status).toBe(200)
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes)
      expect(allowed.headers.get('x-native-file')).toBe('yes')
      expect(opened).toHaveBeenCalledOnce()
      expect(released).toHaveBeenCalledOnce()
      for (const channel of ['/rpc', '/api']) {
        const body = JSON.stringify({ type: 'client-request', rpcId: 'native-id', method: 'echo', payload: { native: true } })
        const rejected = await fetch(`${origin}${channel}/echo`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body })
        expect(rejected.status).toBe(403)
        await rejected.text()
        const accepted = await fetch(`${origin}${channel}/echo`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-fixture-workspace': 'workspace-a' }, body })
        expect(await accepted.json()).toEqual({ type: 'server-response', rpcId: 'native-id', result: { ok: true, value: { native: true } } })
      }
      expect(rpc).toHaveBeenCalledTimes(2)
      expect(released).toHaveBeenCalledTimes(3)
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
