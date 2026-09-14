/** Resource checks compose with the native primary/fallback launcher and real paths. */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { OpenInAppAccessLease } from '../src/access.ts'
import { withOpenInAppAccess } from '../src/access.ts'
import { launchResolved } from '../src/resolver.ts'

function responseFixture() {
  const response = new EventEmitter() as ServerResponse
  response.statusCode = 200
  Object.defineProperty(response, 'headersSent', { value: false })
  response.end = vi.fn(() => response)
  response.destroy = vi.fn(() => response)
  return response
}

it.each(['revoke', 'replace-path'] as const)('rechecks the exact canonical grant before fallback: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'open-in-app-access-'))
  try {
    const target = join(root, 'target')
    const foreign = join(root, 'foreign')
    await mkdir(target)
    await mkdir(foreign)
    const canonical = await realpath(target)
    const lifetime = new AbortController()
    const release = vi.fn()
    const calls: string[] = []
    const completed = Promise.withResolvers<undefined>()
    const response = responseFixture()
    const request = { method: 'POST', url: '/open-in-app/open', headers: {} } as IncomingMessage
    await withOpenInAppAccess({
      async admit() { return { signal: lifetime.signal, canonicalDirectory: canonical, async check() {}, release } },
    }, true, new AbortController().signal, request, response,
    { kind: 'launch', appId: 'fixture', directory: target }, async (check, path) => {
      try { await launchResolved({
        launch: { kind: 'argv', command: 'primary', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'fallback', args: [] },
      }, path!, 1, { resolveExecutable: () => Promise.resolve(null), async launch(command) {
        calls.push(command)
        if (mode === 'revoke') lifetime.abort(new Error('revoked'))
        else {
          await rename(target, join(root, 'previous'))
          await symlink(foreign, target, 'dir')
        }
        throw new Error('primary failed')
      } }, check) } finally { completed.resolve(undefined) }
    })
    await completed.promise
    expect(calls).toEqual(['primary'])
    expect(response.statusCode).toBe(403)
    expect(release).toHaveBeenCalledOnce()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps a valid canonical path through the native fallback and releases once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-in-app-fallback-'))
  try {
    const canonical = await realpath(root)
    const seen: string[] = []
    const check = vi.fn(async () => {})
    const release = vi.fn()
    const request = { method: 'POST', url: '/open-in-app/open', headers: {} } as IncomingMessage
    await withOpenInAppAccess({ async admit() {
      return { signal: new AbortController().signal, canonicalDirectory: canonical, check, release }
    } }, true, new AbortController().signal, request, responseFixture(),
    { kind: 'launch', appId: 'fixture', directory: root }, async (checkpoint, path) => {
      expect(path).toBe(canonical)
      expect(await launchResolved({
        launch: { kind: 'argv', command: 'primary', args: [] },
        fallbackLaunch: { kind: 'argv', command: 'fallback', args: [] },
      }, path!, 1, { resolveExecutable: () => Promise.resolve(null), async launch(command) {
        seen.push(command)
        if (command === 'primary') throw new Error('primary failed')
      } }, checkpoint)).toBe('launched')
    })
    expect(seen).toEqual(['primary', 'fallback'])
    expect(check).toHaveBeenCalledTimes(3)
    expect(release).toHaveBeenCalledOnce()
  } finally { await rm(root, { recursive: true, force: true }) }
})


it.each(['late', 'handoff'] as const)('releases admission across cancellation settlement: %s', async (order) => {
  const admission = Promise.withResolvers<OpenInAppAccessLease>()
  const entered = Promise.withResolvers<undefined>()
  const response = responseFixture()
  const released = Promise.withResolvers<undefined>()
  const release = vi.fn(() => { released.resolve(undefined) })
  const action = vi.fn(async () => {})
  const pending = withOpenInAppAccess({ admit() { entered.resolve(undefined); return admission.promise } },
    true, new AbortController().signal, { headers: {} } as IncomingMessage, response, { kind: 'catalog' }, action)
  await entered.promise
  const lease = { signal: new AbortController().signal, async check() {}, release }
  if (order === 'late') {
    response.emit('close')
    await pending
    admission.resolve(lease)
  } else {
    admission.resolve(lease)
    queueMicrotask(() => { response.emit('close') })
    await pending
  }
  await released.promise
  expect(response.statusCode).toBe(403)
  expect(release).toHaveBeenCalledOnce()
  expect(action).not.toHaveBeenCalled()
})

it('ends a request while a policy recheck is pending', async () => {
  const entered = Promise.withResolvers<undefined>()
  const checked = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  const release = vi.fn()
  const action = vi.fn(async () => {})
  const response = responseFixture()
  const pending = withOpenInAppAccess({ async admit() {
    return { signal: lifetime.signal, check() { entered.resolve(undefined); return checked.promise }, release }
  } }, true, new AbortController().signal, { headers: {} } as IncomingMessage, response, { kind: 'catalog' }, action)
  await entered.promise
  lifetime.abort(new Error('expired'))
  await pending
  expect(response.statusCode).toBe(403)
  expect(release).toHaveBeenCalledOnce()
  checked.resolve(undefined)
  await checked.promise
  expect(action).not.toHaveBeenCalled()
})

it('denies a synchronously rejected admission without dispatch', async () => {
  const response = responseFixture()
  const action = vi.fn(async () => {})
  await withOpenInAppAccess({ admit() { throw new Error('invalid proof') } }, true,
    new AbortController().signal, { headers: {} } as IncomingMessage, response, { kind: 'catalog' }, action)
  expect(response.statusCode).toBe(403)
  expect(action).not.toHaveBeenCalled()
})
