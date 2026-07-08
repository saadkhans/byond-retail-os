/**
 * PostgreSQL 32-bit `INTEGER` column bounds. Any user-supplied integer that
 * lands in an `Int` column (stock deltas, projected levels, low-stock
 * thresholds) is validated against this range BEFORE reaching Prisma, so an
 * out-of-range value returns a controlled 400/409 instead of an unhandled
 * database range error.
 */
export const PG_INT_MIN = -2_147_483_648;
export const PG_INT_MAX = 2_147_483_647;
