import { EslUpdateErrorCode } from '@prisma/client';

/**
 * The vendor boundary. Core ESL logic compiles and tests against THIS file
 * alone; a concrete vendor is a new adapter plus a `vendorCode` on a gateway,
 * never a change here or in the service (AGENTS.md vendor-neutrality rule).
 *
 * No vendor SDK type may appear in these signatures, and nothing on this
 * boundary carries a credential: the gateway hands the adapter an opaque
 * `credentialRef`, and the adapter resolves it from configuration itself.
 */

/** What a label should display. Deliberately tiny and vendor-neutral. */
export interface EslLabelContent {
  readonly sku: string;
  readonly productName: string;
  /** Minor currency units. Null means "no price resolves" — never "free". */
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

/** Connection context for one gateway, assembled by the service. */
export interface EslGatewayContext {
  readonly gatewayCode: string;
  readonly vendorCode: string;
  /**
   * Opaque configuration key. Adapters look the real credential up from the
   * environment; the value is never logged, persisted, or returned.
   */
  readonly credentialRef: string | null;
  /** Credential-free connection hints, already screened on write. */
  readonly metadata: Record<string, unknown> | null;
}

/** A label as the vendor reports it. */
export interface EslVendorLabel {
  readonly vendorLabelId: string;
  readonly batteryPercent?: number;
  readonly signalPercent?: number;
}

export interface EslPushRequest {
  readonly vendorLabelId: string;
  readonly content: EslLabelContent;
}

/**
 * One label's outcome. A failure names a CODE from the closed vocabulary; the
 * optional message is vendor text kept for operators and screened before it
 * is persisted.
 */
export type EslPushOutcome =
  | { readonly vendorLabelId: string; readonly ok: true; readonly label?: EslVendorLabel }
  | {
      readonly vendorLabelId: string;
      readonly ok: false;
      readonly errorCode: EslUpdateErrorCode;
      readonly message?: string;
    };

export abstract class EslVendorPort {
  /** Matches EslGateway.vendorCode. Uppercase, stable, vendor-neutral. */
  abstract readonly vendorCode: string;

  /** Labels the gateway can see right now. Used to register hardware. */
  abstract discoverLabels(ctx: EslGatewayContext): Promise<EslVendorLabel[]>;

  /** Current health of one label. */
  abstract readHealth(
    ctx: EslGatewayContext,
    vendorLabelId: string,
  ): Promise<EslVendorLabel | null>;

  /**
   * Push content to many labels on one gateway. Batch is the primary verb
   * because a price activation touches many labels at once, and because a
   * single failing label must never hold up the rest — the result is
   * per-label, and an adapter returns one outcome for every request it was
   * given.
   */
  abstract pushBatch(
    ctx: EslGatewayContext,
    requests: readonly EslPushRequest[],
  ): Promise<EslPushOutcome[]>;
}

/** Injection token for the registry that resolves vendorCode → adapter. */
export const ESL_VENDOR_REGISTRY = Symbol('ESL_VENDOR_REGISTRY');

export interface EslVendorRegistryPort {
  /** Null when no adapter claims the code — the caller fails UNKNOWN_VENDOR. */
  resolve(vendorCode: string): EslVendorPort | null;
  /** Codes a deployment can offer an operator. */
  vendorCodes(): string[];
}
