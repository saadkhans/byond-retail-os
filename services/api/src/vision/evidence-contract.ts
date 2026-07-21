/**
 * The Phase 7 MVP evidence contract, shared by the ingest DTO (published
 * OpenAPI schema) and the service validators (runtime enforcement) so the
 * two can never drift apart.
 *
 * Stance: Phase 7 accepts NO evidence payloads. There are no artifact
 * descriptors, no metadata objects, and no user-supplied provenance
 * strings — an EvidenceBundle is a lightweight lineage record (sourceType
 * enum + capture window) that basket lines and reviews can point at.
 * External media references arrive in the future evidence storage phase.
 *
 * The only caller-supplied free strings that survive on the vision event
 * are reason codes, and those are strict lowercase slugs.
 */

/**
 * Reason codes are lowercase word/number segments joined by `.`, `_` or
 * `-` (occlusion, low-confidence, multi-hand). Lowercase-only is
 * deliberate: it keeps codes readable and vendor-neutral, and leaves no
 * room for case-mixed encoded content.
 */
export const REASON_CODE_PATTERN = '^[a-z0-9]+(?:[._-][a-z0-9]+)*$';
export const REASON_CODE_REGEX = new RegExp(REASON_CODE_PATTERN);

export const MAX_REASON_CODES = 20;
export const MAX_REASON_CODE_LENGTH = 64;
