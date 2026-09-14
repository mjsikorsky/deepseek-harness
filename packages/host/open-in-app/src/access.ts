/** Deployment authority for native application discovery and directory launches. */
import type {} from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Parsed native operation; the request is not itself authority. */
export type OpenInAppOperation =
  | { readonly kind: 'catalog' }
  | { readonly kind: 'icon'; readonly appId: string }
  | { readonly kind: 'launch'; readonly appId: string; readonly directory: string }

/** Immutable original request facts paired with a parsed operation. */
export interface OpenInAppAccessRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly operation: OpenInAppOperation
  readonly signal: AbortSignal
}

/** One finite grant; launch grants bind one canonical directory. */
export interface OpenInAppAccessLease {
  readonly signal: AbortSignal
  readonly canonicalDirectory?: string
  /** Revalidate current resource authority before another native observation or launch. */
  check(): Promise<void>
  /** Release only this request's authority, not a previously launched application. */
  release(): void
}

/** Deployment-owned identity and resource policy, independent of native browser authentication. */
export interface OpenInAppAccessPolicy {
  /**
   * Verify the request and grant its parsed operation using trusted workspace/machine capabilities.
   * @param request - immutable request facts and desired operation.
   * @returns finite grant, or undefined to deny before native resource access.
   */
  admit(request: OpenInAppAccessRequest): Promise<OpenInAppAccessLease | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment policy for native installed-app reads and directory launches. */
    openInAppAccess: OpenInAppAccessPolicy
  }
}

class AccessDenied extends Error {}

function untilAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new AccessDenied('Application access ended')) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Execute an unchanged native route with finite resource checks and a fixed granted target.
 * @param provider - deployment policy resolved for this request.
 * @param required - deny when the deployment requires a missing provider.
 * @param ownerSignal - native plugin lifetime.
 * @param request - original native HTTP request, after browser authentication.
 * @param response - original response; no competing route or response format is introduced.
 * @param operation - operation parsed by the native owner.
 * @param action - native handler continuation; checks precede observations, replies and every launcher attempt.
 * @returns completion of this response's native action or authorization denial.
 */
export async function withOpenInAppAccess(
  provider: OpenInAppAccessPolicy | undefined, required: boolean, ownerSignal: AbortSignal,
  request: IncomingMessage, response: ServerResponse, operation: OpenInAppOperation,
  action: (check: () => Promise<void>, directory?: string) => Promise<void>,
): Promise<void> {
  const deny = (): void => {
    if (response.headersSent) response.destroy()
    else { response.statusCode = 403; response.end() }
  }
  if (provider === undefined) {
    if (required) deny()
    else await action(() => Promise.resolve(), operation.kind === 'launch' ? operation.directory : undefined)
    return
  }
  const disconnected = new AbortController()
  const abort = (): void => { if (!response.writableEnded) disconnected.abort() }
  response.once('close', abort)
  const requestSignal = AbortSignal.any([ownerSignal, disconnected.signal])
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) =>
    [key, Array.isArray(value) ? Object.freeze([...value]) : value]))
  const facts: OpenInAppAccessRequest = Object.freeze({
    method: request.method ?? 'GET', url: request.url ?? '/', headers: Object.freeze(headers),
    operation: Object.freeze({ ...operation }), signal: requestSignal,
  })
  let offered: OpenInAppAccessLease | undefined
  let admissionFailed = false
  let lease: OpenInAppAccessLease | undefined
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    lease?.release()
  }
  let signal: AbortSignal | undefined
  try {
    requestSignal.throwIfAborted()
    const admission = Promise.resolve().then(() => provider.admit(facts))
    void admission.then((value) => { offered = value; if (admissionFailed) value?.release() }, () => {})
    try { lease = await untilAbort(requestSignal, admission) } catch {
      admissionFailed = true
      offered?.release()
      throw new AccessDenied('Application admission denied')
    }
    if (lease === undefined) throw new AccessDenied('Application admission denied')
    const granted = lease
    signal = AbortSignal.any([requestSignal, granted.signal])
    const lifetime = signal
    lifetime.addEventListener('abort', release, { once: true })
    const directory = operation.kind === 'launch' ? granted.canonicalDirectory : undefined
    if (operation.kind === 'launch' && (directory === undefined || !isAbsolute(directory))) {
      throw new AccessDenied('Application launch requires a canonical directory grant')
    }
    const check = async (): Promise<void> => {
      lifetime.throwIfAborted()
      try { await granted.check() } catch { throw new AccessDenied('Application access denied') }
      lifetime.throwIfAborted()
      if (directory !== undefined) {
        let current: string
        try { current = await realpath(directory) } catch { throw new AccessDenied('Granted directory is unavailable') }
        if (current !== directory) throw new AccessDenied('Granted directory changed')
        lifetime.throwIfAborted()
      }
    }
    await untilAbort(lifetime, check())
    await untilAbort(lifetime, action(check, directory))
  } catch (error) {
    if (error instanceof AccessDenied || requestSignal.aborted || signal?.aborted === true) deny()
    else throw error
  } finally {
    signal?.removeEventListener('abort', release)
    release()
    response.removeListener('close', abort)
  }
}
