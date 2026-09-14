import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  SESSION_LOG_FILENAME,
  SESSION_LOG_EXPORT_PATH,
  apply,
  inject,
} from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId

function readHandle(id: string): SessionHandle {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    delegationDepth: 0,
  }
  return {
    id: header.id,
    header,
    access: 'read',
    read: async () => ({ eventState: 'detached', events: [] }),
    close: async () => {},
  } as unknown as SessionHandle
}

async function mounted(withServices: boolean): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  if (withServices) {
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => ({ header: readHandle(String(id)).header }),
      open: async (id: SessionId) => readHandle(String(id)),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { connection, dispose: () => fiber.dispose() }
}

describe('Session log export Fetch route', () => {
  it('registers one GET/HEAD route and removes it with the plugin fiber', async () => {
    const { connection, dispose } = await mounted(true)
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files[SESSION_LOG_FILENAME] as Uint8Array)).toContain('"id":"session-1"')

    const head = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`, { method: 'HEAD' },
    ))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()

    await dispose()
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(404)
  })

  it('validates the query before reporting missing export services', async () => {
    const { connection, dispose } = await mounted(false)
    const shared = connection.createSharedFetchHandler('/api')
    expect((await shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}`))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1&includeDescendants=1`,
    ))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(500)
    await dispose()
  })

  it('validates the compression level', () => {
    expect(Config({})).toEqual({ compressionLevel: 6 })
    expect(Config({ compressionLevel: 0 })).toEqual({ compressionLevel: 0 })
    expect(Config({ compressionLevel: 9 })).toEqual({ compressionLevel: 9 })
    for (const compressionLevel of [-1, 10, 1.5]) {
      expect(() => Config({ compressionLevel } as never)).toThrow()
    }
  })
})

/** A real cold native JSONL Session, SQLite query owner and native ZIP producer. */
async function guardedExport() {
  const directory = await mkdtemp(join(tmpdir(), 'native-guarded-export-'))
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: directory })
  for (const id of ['authorized-export', 'foreign-export']) {
    const stored = await ctx.sessionPersistence.create(readHandle(id).header)
    try {
      await stored.append([{ type: 'user/message', seq: SessionSeq(0), time: 2, surfaceOp: 'append',
        data: createUserMessage({ content: [{ type: 'text', text: 'private native history ' + id }], source: { kind: 'user' } }),
      }])
    } finally { await stored.close() }
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth, true)
  await ctx.plugin({ inject: [...inject], apply })
  return { ctx, shared: connection.createSharedFetchHandler('/api'), async close() { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

describe('native Session export request authority', () => {
  it('denies unowned roots/descendant expansion before native reads and retains the lease through the ZIP body', async () => {
    const f = await guardedExport()
    try {
      const open = vi.spyOn(f.ctx.sessionPersistence, 'open')
      const trace = vi.spyOn(f.ctx.sessionQuery, 'traceSession')
      const allowed = `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=authorized-export`
      expect((await f.shared.fetch(new Request(allowed))).status).toBe(403)
      expect(open).not.toHaveBeenCalled()
      let released = 0
      const life = new AbortController()
      f.ctx.provide('connectionRequestPolicy', { async admit(metadata) {
        const query = new URL(metadata.url).searchParams
        if (query.get('sessionId') !== 'authorized-export' || query.get('includeDescendants') === 'true') return
        return { signal: life.signal,
          async run<T>(dispatch: () => Promise<T>) { life.signal.throwIfAborted(); return dispatch() },
          release() { released++ },
        }
      } })
      expect((await f.shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}?sessionId=foreign-export`))).status).toBe(403)
      expect((await f.shared.fetch(new Request(allowed + '&includeDescendants=true'))).status).toBe(403)
      expect(open).not.toHaveBeenCalled()
      expect(trace).not.toHaveBeenCalled()
      const response = await f.shared.fetch(new Request(allowed))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/zip')
      expect(released).toBe(0)
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
      expect(strFromU8(files[SESSION_LOG_FILENAME]!)).toContain('private native history authorized-export')
      expect(strFromU8(files[SESSION_LOG_FILENAME]!)).not.toContain('foreign-export')
      expect(released).toBe(1)
      const head = await f.shared.fetch(new Request(allowed, { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(head.body).toBeNull()
      expect(released).toBe(2)
    } finally { await f.close() }
  })

  it('withdraws the actual ZIP response body when its request lease is revoked after headers', async () => {
    const f = await guardedExport()
    try {
      const life = new AbortController(); let released = 0
      f.ctx.provide('connectionRequestPolicy', { async admit() {
        return { signal: life.signal,
          async run<T>(dispatch: () => Promise<T>) { life.signal.throwIfAborted(); return dispatch() },
          release() { released++ },
        }
      } })
      const response = await f.shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}?sessionId=authorized-export`))
      expect(response.status).toBe(200)
      expect(released).toBe(0)
      life.abort(new Error('Current workspace membership revoked'))
      await expect(response.arrayBuffer()).rejects.toThrow('Current workspace membership revoked')
      await vi.waitFor(() => { expect(released).toBe(1) })
    } finally { await f.close() }
  })
})
