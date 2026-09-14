import { runInNewContext } from 'node:vm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import { FileUploads } from '../src/index.ts'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type ConnectionRequestPolicy } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handleFileUploadHttp(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleFileUploadHttp(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleFileUploadHttp(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handleFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handleFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})

/** Actual FileUploads, native Agent scope and filesystem attachment owner. */
async function guardedUploads() {
  const directory = await mkdtemp(join(tmpdir(), 'native-guarded-upload-'))
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, CommandRuntime]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(LocalAttachmentStore, { dshHome: directory })
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth, true)
  await ctx.plugin(FileUploads)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agents.create({ sessionId: SessionId('authorized-upload') })
  const shared = connection.createSharedFetchHandler('/api')
  return { ctx, agent, shared, async close() { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

describe('native upload route request authority', () => {
  it('denies missing/foreign authority before storage and retains an admitted lease until receipt delivery', async () => {
    const f = await guardedUploads()
    try {
      const save = vi.spyOn(f.ctx.attachments, 'saveFileStream')
      const first = await f.shared.fetch(request({ sessionId: 'authorized-upload', contentType: 'application/octet-stream', body: Uint8Array.of(1) }))
      expect(first.status).toBe(403)
      expect(save).not.toHaveBeenCalled()
      let released = 0
      const life = new AbortController()
      const policy: ConnectionRequestPolicy = { async admit(metadata) {
        expect(Object.isFrozen(metadata)).toBe(true)
        expect(Object.isFrozen(metadata.headers)).toBe(true)
        if (new URL(metadata.url).searchParams.get('sessionId') !== 'authorized-upload') return
        return { signal: life.signal, async run(dispatch) { life.signal.throwIfAborted(); return dispatch() }, release() { released++ } }
      } }
      f.ctx.provide('connectionRequestPolicy', policy)
      expect((await f.shared.fetch(request({ sessionId: 'foreign-upload', contentType: 'application/octet-stream', body: Uint8Array.of(2) }))).status).toBe(403)
      expect(save).not.toHaveBeenCalled()
      const response = await f.shared.fetch(request({ sessionId: 'authorized-upload', contentType: 'application/octet-stream', name: 'native.bin', body: Uint8Array.of(3, 4, 5) }))
      expect(response.status).toBe(200)
      expect(released).toBe(0)
      const result = await response.json() as { ok: boolean; value: Awaited<ReturnType<FileUploads['uploadStream']>> }
      expect(result.ok).toBe(true)
      expect(released).toBe(1)
      expect(f.ctx.fileUploads.resolve(f.agent.agent, result.value.receiptId)).toEqual(result.value.file)
      const stored: number[] = []
      for await (const chunk of f.ctx.attachments.readFileStream(result.value.file)) stored.push(...chunk)
      expect(stored).toEqual([3, 4, 5])
    } finally { await f.close() }
  })

  it('revokes a partially received native upload, cancels its source and issues no successful receipt', async () => {
    const f = await guardedUploads()
    try {
      const life = new AbortController(); let released = 0; let canceled = 0; let pulls = 0
      const waiting = Promise.withResolvers<undefined>()
      f.ctx.provide('connectionRequestPolicy', { async admit() {
        return { signal: life.signal,
          async run<T>(dispatch: () => Promise<T>) { life.signal.throwIfAborted(); return dispatch() },
          release() { released++ },
        }
      } })
      const save = vi.spyOn(f.ctx.attachments, 'saveFileStream')
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { if (pulls++ === 0) controller.enqueue(Uint8Array.of(8, 9)); else waiting.resolve(undefined) },
        cancel() { canceled++ },
      }, { highWaterMark: 0 })
      const pending = f.shared.fetch(new Request('http://host/api/session/uploadFileBinary?sessionId=authorized-upload', {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
      } as RequestInit & { duplex: 'half' }))
      await Promise.race([waiting.promise, pending.then(() => { throw new Error('Upload ended before its streaming gate') })])
      expect(save).toHaveBeenCalledOnce()
      life.abort(new Error('Current workspace membership revoked'))
      const response = await pending
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('forbidden')
      expect(canceled).toBe(1)
      expect(released).toBe(1)
      await expect(save.mock.results[0]!.value).rejects.toThrow()
    } finally { await f.close() }
  })
})
