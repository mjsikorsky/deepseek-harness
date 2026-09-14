/** Deployment request authority around native handlers and byte streams. */
import type {
  ConnectionRequestLease,
  ConnectionRequestMetadata,
  ConnectionRequestPolicy,
} from './rpc.ts'

interface GuardedBody {
  stream: ReadableStream<Uint8Array>
  cancel(reason?: unknown): Promise<void>
}

function guardedBody(
  source: ReadableStream<Uint8Array>,
  lease: ConnectionRequestLease,
  signal: AbortSignal,
  onEnd: () => Promise<void>,
): GuardedBody {
  const reader = source.getReader()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let stopped = false
  const isStopped = (): boolean => stopped
  let ending: Promise<void> | undefined
  const end = (reason?: unknown, cancel = false): Promise<void> => {
    if (ending !== undefined) return ending
    stopped = true
    signal.removeEventListener('abort', aborted)
    // A source may reject or ignore cancellation. Revoke authority immediately;
    // source cleanup must never retain a request lease or block owner disposal.
    if (cancel) void reader.cancel(reason).catch(() => {}).finally(() => { reader.releaseLock() })
    else reader.releaseLock()
    ending = onEnd()
    return ending
  }
  const aborted = (): void => {
    if (isStopped()) return
    controller.error(signal.reason)
    void end(signal.reason, true).catch(() => {})
  }
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    },
    async pull() {
      if (isStopped()) return
      try {
        signal.throwIfAborted()
        const result = await lease.run(() => reader.read())
        if (isStopped()) return
        signal.throwIfAborted()
        if (result.done) {
          await end()
          controller.close()
        } else controller.enqueue(result.value)
      } catch (error) {
        if (!isStopped()) controller.error(error)
        await end(error, true)
      }
    },
    cancel: reason => end(reason, true),
  }, { highWaterMark: 0 })
  return { stream, cancel: (reason) => {
    if (!isStopped()) controller.error(reason ?? new Error('Request lifetime ended'))
    return end(reason, true)
  } }
}

function cancelBody(body: ReadableStream<Uint8Array> | null, reason?: unknown): void {
  if (body !== null) void body.cancel(reason).catch(() => {})
}

function untilAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled', { cause: signal.reason })) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Admit one native HTTP request and retain its authority through body completion.
 * @param request - original request, with its native body still unconsumed.
 * @param provider - deployment-owned policy, resolved for this invocation.
 * @param required - deny when no policy is installed.
 * @param ownerSignal - Connection provider lifetime.
 * @param track - register the complete request/response lifetime for teardown.
 * @param dispatch - unchanged native route or RPC handler.
 * @returns original response metadata and authorized byte streams, or a 403 denial.
 */
export async function dispatchWithRequestPolicy(
  request: Request,
  provider: ConnectionRequestPolicy | undefined,
  required: boolean,
  ownerSignal: AbortSignal,
  track: (done: Promise<void>) => void,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const deny = (): Response => {
    cancelBody(request.body, new Error('Request denied'))
    return new Response('forbidden', { status: 403 })
  }
  if (provider === undefined) return required ? deny() : dispatch(request)
  const metadata: ConnectionRequestMetadata = Object.freeze({
    method: request.method,
    url: request.url,
    headers: Object.freeze(Object.fromEntries(request.headers)),
    signal: AbortSignal.any([request.signal, ownerSignal]),
  })
  let admitted: ConnectionRequestLease | undefined
  let offered: ConnectionRequestLease | undefined
  let admissionFailed = false
  try {
    metadata.signal.throwIfAborted()
    const admission = Promise.resolve(provider.admit(metadata))
    void admission.then((value) => {
      offered = value
      if (admissionFailed) value?.release()
    }, () => {})
    admitted = await untilAbort(metadata.signal, admission)
  } catch {
    admissionFailed = true
    offered?.release()
    return deny()
  }
  if (admitted === undefined) return deny()
  const lease = admitted
  const signal = AbortSignal.any([metadata.signal, lease.signal])
  const completion = Promise.withResolvers<void>()
  track(completion.promise)
  let input: GuardedBody | undefined
  let finished = false
  const finish = (): Promise<void> => {
    if (finished) return completion.promise
    finished = true
    signal.removeEventListener('abort', abort)
    void input?.cancel(signal.reason).catch(() => {})
    try { lease.release() } finally { completion.resolve() }
    return completion.promise
  }
  const abort = (): void => { void finish() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    if (request.body !== null) input = guardedBody(request.body, lease, signal, () => Promise.resolve())
    const scoped = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      ...(input === undefined ? {} : { body: input.stream, duplex: 'half' }),
    })
    const dispatched = Promise.resolve(lease.run(() => dispatch(scoped)))
    void dispatched.then((response) => {
      if (signal.aborted) cancelBody(response.body, signal.reason)
    }, () => {})
    const response = await untilAbort(signal, dispatched)
    signal.throwIfAborted()
    if (response.body === null) { await finish(); return response }
    const output = guardedBody(response.body, lease, signal, finish)
    return new Response(output.stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    const revoked = signal.aborted
    await finish()
    if (revoked) return new Response('forbidden', { status: 403 })
    throw error
  }
}
