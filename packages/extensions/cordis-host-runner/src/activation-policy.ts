/** Deployment authority for admitting exact dynamic Host source into the trusted process. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CordisDynamicPluginId, CordisDynamicPackageId, CordisDynamicPluginRunId } from './types.ts'

/** Immutable native identity and source; actor privileges come from the provider's verified context. */
export interface CordisHostActivationRequest {
  /** Native session owning the package. */
  readonly sessionId: SessionId
  /** Stable native plugin identity. */
  readonly pluginId: CordisDynamicPluginId
  /** Immutable native package version. */
  readonly packageId: CordisDynamicPackageId
  /** Exact native activation attempt. */
  readonly pluginRunId: CordisDynamicPluginRunId
  /** Exact stored Host source to authorize, not a caller-submitted substitute. */
  readonly hostCode: string
  /** Human-readable package label, not authority. */
  readonly name: string
  /** Human-readable explanation, not authority. */
  readonly purpose: string
}
/** Finite trusted-code admission. Revocation retracts the native run; it cannot undo trusted code's effects. */
export interface CordisHostActivationLease {
  /** Absolute expiry in milliseconds, captured once by the native owner. */
  readonly expiresAt: number
  /** Provider revocation lifetime. */
  readonly signal: AbortSignal
  /** Recheck current authority synchronously; throw to refuse continued activation. */
  check(): void
  /** Release provider resources once after native retraction or failed admission. */
  release(): void
}
/** Deployment provider; a session write permission is not permission to trust Host code. */
export interface CordisHostActivationPolicy {
  /**
   * Authorize exact Host source using current verified approver privileges.
   * @param request - Native identity and immutable source snapshot.
   * @param signal - Native stop, undefine and runner-disposal cancellation.
   * @returns A finite admission, or undefined to deny.
   */
  authorize(request: Readonly<CordisHostActivationRequest>, signal: AbortSignal): Promise<CordisHostActivationLease | undefined>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    cordisHostActivationPolicy: CordisHostActivationPolicy
  }
}

/**
 * Acquire once, dispose late admissions, and retain the finite lease until native retraction.
 * @param policy - Deployment authority provider.
 * @param request - Native package and exact source snapshot.
 * @param lifetime - Native activation cancellation lifetime.
 * @param revoked - Withdraw the pending or active native Host fiber.
 * @returns Captured authority, checks and one-shot cleanup.
 */
export async function admitHostCode(
  policy: CordisHostActivationPolicy,
  request: CordisHostActivationRequest,
  lifetime: AbortSignal,
  revoked: () => void,
): Promise<{ signal: AbortSignal; check(): void; release(): void }> {
  lifetime.throwIfAborted()
  const active = new AbortController()
  let lease: CordisHostActivationLease | undefined
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const release = (): void => {
    if (finished) return
    finished = true
    active.abort()
    clearTimeout(timer)
    lifetime.removeEventListener('abort', abort)
    lease?.signal.removeEventListener('abort', abort)
    lease?.release()
  }
  const abort = (): void => { try { revoked() } finally { release() } }
  const check = (): void => {
    const current = lease
    if (current === undefined) throw new Error('dynamic Host code admission is missing')
    // Provider callbacks can revoke or release synchronously; re-read after each callback.
    const live = (): boolean => !finished && !lifetime.aborted && !current.signal.aborted && Date.now() < current.expiresAt
    if (!live()) throw new Error('dynamic Host code admission is expired or revoked')
    current.check()
    if (!live()) throw new Error('dynamic Host code admission was revoked during validation')
  }
  let cancel!: () => void
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => { reject(new Error('dynamic Host code admission was cancelled')) }
    lifetime.addEventListener('abort', cancel, { once: true })
  })
  const acquiring = Promise.resolve().then(() => {
    lifetime.throwIfAborted()
    return policy.authorize(Object.freeze({ ...request }), lifetime)
  }).then((value) => {
    // Take cleanup ownership in the same continuation that publishes the result.
    if (finished) {
      value?.release()
      return undefined
    }
    lease = value
    return value
  })
  try {
    lease = await Promise.race([acquiring, stopped])
    if (lease === undefined) throw new Error('dynamic Host code admission was denied')
    lease = Object.freeze({
      expiresAt: lease.expiresAt, signal: lease.signal,
      check: lease.check.bind(lease), release: lease.release.bind(lease),
    })
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) {
      throw new Error('dynamic Host code admission requires a finite future expiry')
    }
    lifetime.addEventListener('abort', abort, { once: true })
    lease.signal.addEventListener('abort', abort, { once: true })
    check()
    const expiresAt = lease.expiresAt
    const expire = (): void => {
      if (Date.now() >= expiresAt) abort()
      else timer = setTimeout(expire, Math.min(expiresAt - Date.now(), 2_147_483_647))
    }
    timer = setTimeout(expire, Math.min(lease.expiresAt - Date.now(), 2_147_483_647))
    timer.unref()
    return { signal: active.signal, check, release }
  } catch (error) {
    release()
    throw error
  } finally {
    lifetime.removeEventListener('abort', cancel)
  }
}

/**
 * Stop waiting for an admitted operation when its authority ends; never republish a late result.
 * @param operation - Native evaluation or fiber startup already owned by the caller.
 * @param signal - Captured admission lifetime, absent for an unrestricted caller.
 * @returns The original result while authority remains valid.
 */
export async function duringHostAdmission<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  let cancel!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => { reject(new Error('dynamic Host code admission was revoked')) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', cancel) }
}
