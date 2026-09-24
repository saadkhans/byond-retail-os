/**
 * Phase 27 — the owned refund-gateway port.
 *
 * Money moving BACK to a shopper is the one payment operation that has no
 * internal-only meaning: an authorization and a capture can be simulated end
 * to end, but a refund ultimately has to be asked of whoever holds the money.
 * So the request leaves the application through THIS interface, which this
 * repository owns, and a provider is a plug-in behind it (AGENTS.md vendor
 * neutrality). Core logic compiles and tests against the interface alone.
 *
 * The only implementation in this release is `SimulatedRefundGateway`. There
 * is still NO live gateway and NO provider SDK anywhere in the codebase.
 *
 * Two properties of the contract are deliberate:
 *
 *   1. The request carries NO card data — only an opaque refund id, the
 *      provider, an amount, a currency, and opaque provider references. A real
 *      adapter looks the instrument up on its own side by `providerRef`; it is
 *      never handed one (AGENTS.md payments invariant).
 *   2. `execute` is called OUTSIDE the database transaction that recorded the
 *      refund, and the refund row already exists as PENDING when it is called.
 *      A gateway that hangs, crashes the process, or answers twice therefore
 *      cannot lose the fact that a refund was requested, and cannot move money
 *      twice: the caller settles the same PENDING row exactly once.
 */

/** What the gateway is asked to return, and against what. Never card data. */
export interface RefundGatewayRequest {
  /** Our refund record's id. A real adapter uses it as ITS idempotency key. */
  readonly refundId: string;
  readonly intentId: string;
  /** The provider the intent was created against ('SIMULATED' | 'MANUAL'). */
  readonly provider: string;
  readonly amountMinor: number;
  readonly currencyCode: string;
  /** Opaque provider reference from the capture, when there is one. */
  readonly providerRef?: string | null;
}

/**
 * The gateway's answer. There is no PENDING outcome by design: an adapter for
 * an asynchronous provider reports what it knows now and settles later through
 * the existing provider-event ingestion path, rather than leaving this call
 * ambiguous.
 */
export interface RefundGatewayResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Opaque reference for the provider-side refund. Never a secret. */
  readonly providerRefundRef?: string;
  /** Short, provider-neutral failure description. Never a raw provider body. */
  readonly failureReason?: string;
}

export interface RefundGateway {
  /** Human-readable name of the concrete adapter, for logs and audit. */
  readonly name: string;
  execute(request: RefundGatewayRequest): Promise<RefundGatewayResult>;
}

/** Nest injection token for the port (an interface has no runtime identity). */
export const REFUND_GATEWAY = Symbol('REFUND_GATEWAY');
