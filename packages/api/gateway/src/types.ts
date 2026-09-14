/**
 * Carrier-independent Typert Gateway request, service, and error contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteEventHostInfo } from './stream-protocol.ts'

/** One Remote method request after a carrier has decoded its envelope. */
export interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  readonly namespace: string
  /** Exported Service method name. */
  readonly method: string
  /** Named wire values; fields must exactly match the descriptor. */
  readonly args: Readonly<Record<string, unknown>>
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  readonly signal?: AbortSignal
}

/** One Host Cordis notification forwarded unchanged to Client Remote subscribers. */
export interface TypertRemoteEventFrame {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Original event argument list after the owner validates it for JSON transport. */
  readonly args: readonly unknown[]
}

/** Live Host values used to project one scoped Remote Event. */
export interface TypertRemoteEventContext {
  /** Live Agent Context that owns cancellation of the forwarded waterfall. */
  readonly value: Context
  /** Agent object carried directly by the waterfall request. */
  readonly subject: object
  /** Agent identity read directly from the scoped event subject. */
  readonly agentId: string
}

/** Result returned from a Client waterfall, or delegation back to the Host chain. */
export type TypertRemoteEventOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }

/**
 * One scoped waterfall invocation yielded by the application event source.
 * The Gateway alone assigns transport ids and resolves the continuation after
 * a Client result or explicit delegation.
 */
export interface TypertRemoteEventInvocation {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Sole request argument before the waterfall's `next()` callback. */
  readonly request: object
  readonly context: TypertRemoteEventContext
  /** Resume the source's Cordis listener with a Client result or `next()`. */
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  /** Reject the source's Cordis listener after cancellation, transport failure, or Client rejection. */
  readonly reject: (reason: unknown) => void
}

/** Notification or scoped waterfall accepted from the sole Remote Event source. */
export type TypertRemoteEventDispatch = TypertRemoteEventFrame | TypertRemoteEventInvocation

/**
 * Open the application-selected event stream for one Client carrier. The
 * factory must attach all incremental Host listeners before it returns; the
 * Gateway publishes its readiness item immediately afterward.
 * @param signal - cancellation shared with the Client stream and registration.
 * @returns the long-lived stream of notifications and scoped waterfall invocations.
 */
export type TypertRemoteEventSource = (
  signal: AbortSignal,
) => AsyncIterable<TypertRemoteEventDispatch>

/** Carrier-facing access to decoded Remote streams and their stable failures. */
export interface TypertGatewayWireStream {
  /**
   * Open one logical stream from its wire endpoint and payload.
   * @param endpoint - canonical Remote endpoint or Gateway-owned stream name.
   * @param payload - decoded carrier payload.
   * @param signal - logical-stream cancellation.
   * @returns validated stream values.
   */
  readonly open: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>

  /**
   * Convert a stream failure to the carrier-safe Remote failure fields.
   * @param error - failure raised while opening or consuming a stream.
   * @returns stable code, message, and details for the Client.
   */
  readonly failure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** Stable infrastructure and boundary failures emitted before or after business execution. */
export type TypertGatewayErrorCode =
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/input-invalid'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/provider-mismatch'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'

/** Host dispatcher consumed by Connection adapters. */
export interface TypertGateway {
  /** Carrier adapter shared by WebSocket and in-process transports. */
  readonly wireStream: TypertGatewayWireStream

  /**
   * Register the application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this exact source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>

  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint and named wire arguments.
   * @returns a cancellation-aware iterable over the business results.
   */
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host dispatcher for Typert Remote calls. */
    typertGateway: TypertGateway
  }
}

/** Original request facts presented to a trusted, installed access provider. */
export interface GatewayCarrierRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

/** Native wire operation; the Gateway continues to own all decoding and dispatch. */
export interface GatewayAccessOperation {
  readonly endpoint: string
  readonly payload: unknown
}

/** Per-request/transport capability. No browser value can construct this lease. */
export interface GatewayAccessLease {
  readonly signal: AbortSignal
  /**
   * Run native dispatch within a provider-owned, invocation-bounded authority scope.
   * @param operation - operation already accepted by this lease.
   * @param dispatch - original native call or iterator advancement.
   * @returns the unchanged native result; inherited authority ends when this call settles.
   */
  run<T>(operation: GatewayAccessOperation, dispatch: () => Promise<T>): Promise<T>
  /**
   * Authorize an operation before its native implementation runs.
   * @param operation - native endpoint and decoded carrier payload.
   * @returns after authorization, or rejects without invoking the native operation.
   */
  check(operation: GatewayAccessOperation): Promise<void>
  /**
   * Authorize/project a settled result or one stream item before delivery.
   * @param operation - operation that produced the value.
   * @param value - native result before client delivery.
   * @returns an authorized value, or a drop decision; hidden waterfalls lose their native delivery record.
   */
  project(
    operation: GatewayAccessOperation, value: unknown,
  ): Promise<{ readonly keep: true; readonly value: unknown } | { readonly keep: false }>
  /** Release this carrier without deleting native work or history. */
  release(): void
}

/** Trusted deployment provider; absence/denial is never a default identity. */
export interface GatewayAccessProvider {
  /**
   * Verify carrier authority and capture its independently expiring lifetime.
   * @param request - original request facts, including server-forwarded proof headers.
   * @returns one owned lease, or undefined to deny the request.
   */
  admit(request: GatewayCarrierRequest): Promise<GatewayAccessLease | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-owned admission and delivery policy for native Remote carriers. */
    gatewayAccess: GatewayAccessProvider
  }
}
