/**
 * The contract between BYOND and whatever system actually receives a purchase
 * order — an EDI gateway, a supplier portal, an ERP bridge, or a person with
 * an inbox.
 *
 * It is a PORT this repository owns (AGENTS.md vendor neutrality): no supplier
 * SDK type appears in the domain, and supporting a new supplier means writing
 * a new adapter and changing a configuration value, never touching the
 * purchase-order lifecycle.
 *
 * Everything crossing this boundary is deliberately small and opaque. The
 * adapter is given what a supplier legitimately needs to fulfil an order and
 * nothing else: no credentials, no internal ids beyond the reference the
 * supplier will quote back, and no pricing the supplier did not set.
 */

export interface SupplierOrderLine {
  /** The supplier's own identifier for the product, from SupplierProduct. */
  supplierSku: string;
  /** Our SKU, so a human reading the supplier's paperwork can reconcile it. */
  sku: string;
  productName: string;
  /** Packs ordered. */
  quantity: number;
  packSize: number;
  unitCostMinor: number;
  currencyCode: string;
}

export interface SupplierOrderRequest {
  /** Our human-facing reference (PO-2026-0001) — the shared vocabulary. */
  reference: string;
  supplierCode: string;
  supplierName: string;
  /** Where the goods go, by code and name — never an internal id. */
  destinationCode: string;
  destinationName: string;
  expectedAt: Date | null;
  currencyCode: string;
  totalCostMinor: number;
  lines: readonly SupplierOrderLine[];
}

/**
 * A closed vocabulary. An adapter reports why a submission failed without
 * echoing a provider message, which could carry a URL, a credential, or
 * customer data into our logs and audit trail.
 */
export type SupplierSubmissionFailure =
  | 'SUPPLIER_UNREACHABLE'
  | 'SUPPLIER_REJECTED'
  | 'INVALID_ORDER'
  | 'TIMEOUT'
  | 'UNSUPPORTED';

export interface SupplierSubmissionAccepted {
  status: 'ACCEPTED';
  /**
   * The supplier's acknowledgement reference, stored on the order so a human
   * can quote it. Adapters must return an opaque token — never a URL and
   * never anything they were given in confidence.
   */
  externalReference: string;
  acknowledgedAt: Date;
}

export interface SupplierSubmissionRejected {
  status: 'REJECTED';
  failure: SupplierSubmissionFailure;
}

export type SupplierSubmissionResult =
  | SupplierSubmissionAccepted
  | SupplierSubmissionRejected;

export interface SupplierIntegrationPort {
  /** Identifies the adapter in audit entries and in the admin UI. */
  readonly providerCode: string;

  /**
   * Sends an order to the supplier. Implementations must never throw for an
   * ordinary failure — a rejection is a value, so the caller can record it
   * and let an operator retry without an exception crossing the boundary.
   */
  submitOrder(
    request: SupplierOrderRequest,
  ): Promise<SupplierSubmissionResult>;
}

export const SUPPLIER_INTEGRATION_PORT = Symbol('SUPPLIER_INTEGRATION_PORT');
