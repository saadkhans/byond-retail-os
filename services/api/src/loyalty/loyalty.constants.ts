/** Platform module code gating every loyalty and promotion route. */
export const LOYALTY_MODULE_CODE = 'loyalty';

/**
 * PostgreSQL `integer` ceiling. Points are INTEGERS (there is no such thing as
 * a fraction of a point) and both `points` and `balanceAfter` are int4, so the
 * service refuses a movement that would push a balance past this rather than
 * letting Postgres raise an out-of-range error the API cannot explain.
 */
export const LOYALTY_POINTS_MAX = 2147483647;

/** Default and maximum page sizes for the account, ledger and promotion lists. */
export const LOYALTY_DEFAULT_TAKE = 50;
export const LOYALTY_MAX_TAKE = 200;

/** Basis points in 100%. A PERCENT_OFF rule value is in these units. */
export const BASIS_POINTS_PER_WHOLE = 10000;

/**
 * Advisory-lock key for one loyalty account's ledger.
 *
 * Every append takes it, so the reads that establish the ledger tail
 * (sequence number and derived balance) cannot interleave with another
 * append for the SAME account. The unique (accountId, sequenceNumber) index
 * and the `balanceAfter >= 0` CHECK are the database-level backstops if this
 * lock is ever bypassed — see the Phase 29 migration.
 */
export function loyaltyLedgerAdvisoryLockKey(
  tenantId: string,
  accountId: string,
): string {
  return `loyalty-ledger:${tenantId}:${accountId}`;
}
