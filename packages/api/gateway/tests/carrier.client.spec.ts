import { parseRemoteStreamClientMessage } from '../src/stream-protocol.ts'
import { describe, it, expect, vi } from 'vitest'
import { RemoteStreamMuxClient } from '../src/client/stream-client.ts'
import type { ClientMuxSocket } from '@deepseek-ai/dsh-client-connection/client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
class Socket extends EventTarget implements ClientMuxSocket {
  readyState = 1
  readonly sent: string[] = []
  closes = 0
  send(data: string) { this.sent.push(data) }
  close() {
    this.closes++
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
}

describe('native physical socket factory', () => {
  it('awaits carrier preparation, retaining native framing and cancellation', async () => {
    const prepared = deferred<ClientMuxSocket>()
    const socket = new Socket()
    let carrierSignal: AbortSignal | undefined
    const mux = new RemoteStreamMuxClient((url, signal) => {
      expect(url).toMatch(/\/api\/remote\.mux$/)
      carrierSignal = signal
      return prepared.promise
    })
    const lifetime = new AbortController()
    try {
      mux.start()
      const stream = mux.open('session/follow', { args: { request: { value: 'original' } } }, lifetime.signal)
      const next = stream.next()
      expect(socket.sent).toEqual([])
      prepared.resolve(socket)
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
      const opened = parseRemoteStreamClientMessage(socket.sent[0]!)
      if (opened.type !== 'open') throw new Error('expected native open frame')
      expect(opened).toMatchObject({ type: 'open', endpoint: 'session/follow', payload: { args: { request: { value: 'original' } } } })
      socket.receive({ type: 'item', streamId: opened.streamId, value: { native: 'payload' } })
      expect(await next).toEqual({ done: false, value: { native: 'payload' } })
      await stream.return(undefined)
      expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'cancel', streamId: opened.streamId })
      await mux.close()
      expect(carrierSignal?.aborted).toBe(true)
    } finally { lifetime.abort(); prepared.resolve(socket); await mux.close() }
  })

  it('cancels an unresolved attempt, closes its late socket and reconnects through the factory', async () => {
    const first = deferred<ClientMuxSocket>()
    const old = new Socket()
    const replacement = new Socket()
    const signals: AbortSignal[] = []
    const mux = new RemoteStreamMuxClient((_url, signal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : replacement
    })
    try {
      mux.start()
      mux.reconnect()
      expect(signals[0]?.aborted).toBe(true)
      await vi.waitFor(() => { expect(signals).toHaveLength(2) })
      first.resolve(old)
      await vi.waitFor(() => { expect(old.readyState).toBe(3) })
      expect(old.closes).toBe(1)
      expect(replacement.readyState).toBe(1)
      expect(signals[1]?.aborted).toBe(false)
      await mux.close()
      expect(signals[1]?.aborted).toBe(true)
    } finally { first.resolve(old); await mux.close() }
  })

  it('disposes during preparation and closes late results without restarting', async () => {
    const prepared = deferred<ClientMuxSocket>()
    const late = new Socket()
    const factory = vi.fn((_url: string, _signal: AbortSignal) => prepared.promise)
    const mux = new RemoteStreamMuxClient(factory)
    try {
      mux.start()
      await mux.close()
      expect(factory.mock.calls[0]![1].aborted).toBe(true)
      prepared.resolve(late)
      await vi.waitFor(() => { expect(late.closes).toBe(1) })
      mux.start()
      expect(factory).toHaveBeenCalledTimes(1)
    } finally { prepared.resolve(late); await mux.close() }
  })

  it('keeps two page-owned factories independent and aborts only the lost carrier', async () => {
    const a = new Socket(), b = new Socket()
    const signals: AbortSignal[] = []
    const left = new RemoteStreamMuxClient((_url, signal) => { signals.push(signal); return a })
    const right = new RemoteStreamMuxClient((_url, signal) => { signals.push(signal); return b })
    try {
      left.start(); right.start()
      await vi.waitFor(() => { expect(signals).toHaveLength(2) })
      await left.close()
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[1]?.aborted).toBe(false)
      expect(b.readyState).toBe(1)
    } finally { await left.close(); await right.close() }
  })

  it('rejects a factory result already closed before delivery', async () => {
    const closed = new Socket()
    closed.close()
    const mux = new RemoteStreamMuxClient(async () => closed)
    const lifetime = new AbortController()
    try {
      mux.start()
      const stream = mux.open('session/follow', {}, lifetime.signal)
      await expect(stream.next()).rejects.toThrow('WebSocket closed')
      expect(closed.sent).toEqual([])
    } finally { lifetime.abort(); await mux.close() }
  })

  it('settles a synchronous factory failure through native waiter rejection', async () => {
    const mux = new RemoteStreamMuxClient(() => { throw new Error('grant denied') })
    const lifetime = new AbortController()
    try {
      mux.start()
      const stream = mux.open('session/follow', {}, lifetime.signal)
      await expect(stream.next()).rejects.toThrow('carrier preparation failed')
    } finally { lifetime.abort(); await mux.close() }
  })
})
