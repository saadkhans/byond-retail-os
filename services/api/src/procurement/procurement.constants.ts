/** Platform module code gating every procurement route. */
export const PROCUREMENT_MODULE_CODE = 'procurement';

/**
 * referenceType stamped on the ledger movements a goods receipt writes. The
 * pair (referenceType, referenceId) is what makes every received unit
 * traceable back to the receipt that admitted it — and what a reconciliation
 * query joins on.
 */
export const RECEIPT_MOVEMENT_REFERENCE_TYPE = 'GoodsReceipt';

/** Reference prefixes for the two human-facing sequences. */
export const PURCHASE_ORDER_REFERENCE_PREFIX = 'PO';
export const GOODS_RECEIPT_REFERENCE_PREFIX = 'GR';
