import { api, ApiError, Paginated, Unit } from '../api';
import { useLoad } from '../components';

/**
 * Pieces shared by the single-clip and batch tabs of Clip Lab. Kept in a
 * leaf module (no JSX) so the two page files never import each other.
 */

export const STEP_LABELS: Record<string, string> = {
  SCREENING: 'Screened',
  VALIDATE: 'Validated',
  DETECTION: 'Detection',
  FUSION: 'Fusion',
  PRETRAINED: 'Pretrained',
};

export const STEP_BADGE: Record<string, string> = {
  OK: 'ok',
  SKIPPED: '',
  NOT_RUN: '',
  FAILED: 'warn',
  BLOCKED: 'warn',
};

export const MATCH_LABELS: Record<string, string> = {
  MATCH: 'Expected in this cell',
  ADJACENT_MATCH: 'Found in neighboring cell',
  RACK_MATCH: 'Expected on this rack',
  OUT_OF_PLANOGRAM: 'Possible misplaced product',
  UNKNOWN_CELL: 'Cell mapping uncertain',
  PLANOGRAM_NOT_CONFIGURED: 'Planogram not configured',
};

/** Units of one store — "GET /units?locationId=…" (paginated). */
export function useStoreUnits(locationId: string) {
  return useLoad<Paginated<Unit>>(
    () =>
      locationId
        ? api(`/units?locationId=${encodeURIComponent(locationId)}&take=100`)
        : Promise.resolve({ items: [], total: 0, skip: 0, take: 0 } as Paginated<Unit>),
    [locationId],
  );
}

export function labelFor(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code;
}

export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Request failed';
}
