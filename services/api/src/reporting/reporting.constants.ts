/** The platform module code this phase makes real (Phase 30). */
export const REPORTING_MODULE_CODE = 'reporting';

/**
 * Reporting holds ONE permission of its own, and every route additionally
 * demands the permission that already guards the underlying domain
 * (`order:read`, `inventory:read`, `shrink:read`, `vision:read`). A report is
 * therefore never a side door around an existing grant: it can only ever show
 * numbers the caller was already allowed to read row by row.
 */
export const REPORT_READ_PERMISSION = 'report:read';

/** Default reporting window when the caller names neither end. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Upper bound on the number of PRICE POINTS (product x price version x
 * promotion version x money) one sales report may roll up.
 *
 * The database does the grouping; this cap only decides when to REFUSE. A
 * truncated breakdown would silently understate revenue, so the report asks
 * the caller to narrow the window instead of returning a number that is
 * quietly wrong.
 */
export const MAX_SALES_PRICE_POINTS = 20_000;

/** Same idea for the per-(location, product) inventory balance page. */
export const MAX_BALANCE_ROWS = 500;
export const DEFAULT_BALANCE_ROWS = 100;

/**
 * Every report derives its numbers on read. There is no materialised table,
 * no cache and no scheduled roll-up anywhere in this module, so the answer a
 * caller gets was computed from the ledger and the evaluation tables at
 * `generatedAt` — never from a stored figure that could have drifted away
 * from them. `read-only.spec.ts` pins that claim.
 */
export const DERIVATION_DERIVED_ON_READ = 'DERIVED_ON_READ' as const;

export interface ReportProvenance {
  /** When these numbers were computed. Always "now" — nothing is cached. */
  readonly generatedAt: string;
  readonly derivation: typeof DERIVATION_DERIVED_ON_READ;
  /** The tables every number in this report was summed from. */
  readonly sourceOfTruth: readonly string[];
  /**
   * Always false here. The field exists so a future materialised report
   * cannot be added without answering the question in the payload.
   */
  readonly stale: false;
}

export function provenance(sourceOfTruth: readonly string[]): ReportProvenance {
  return {
    generatedAt: new Date().toISOString(),
    derivation: DERIVATION_DERIVED_ON_READ,
    sourceOfTruth,
    stale: false,
  };
}
