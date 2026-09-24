import { BadRequestException } from '@nestjs/common';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';

/**
 * Phase 27 free-text guards.
 *
 * Every operator string the reverse flow accepts — a return reason, a
 * cancellation reason, a condition note, a cycle-count discrepancy note, a
 * shrink justification — is persisted VERBATIM into an append-only record (the
 * InventoryMovement ledger, an OrderReturn, a CycleCountLine, a ShrinkEvent)
 * AND copied into `AuditLog.reason`, which audit-snapshot redaction does not
 * cover. So a pasted PAN, token or credential URL would sit in the ledger
 * forever, unredactable.
 *
 * The screen is the STRICT free-text predicate (`containsSensitiveFreeText`),
 * the same one the inventory ledger uses — NOT the weaker
 * `containsSensitiveValue`: the weak PAN detector only bridges space/dash
 * separators and its credential detectors need '='/':', so a dot- or
 * underscore-grouped PAN ("4111.1111.1111.1111", "4111_1111_1111_1111") and
 * fused credential labels ("cvv123", "password hunter2") would slip through.
 * Rejection is a controlled 400 BEFORE any repository write; redaction is only
 * ever a backstop (AGENTS.md payments invariant).
 */
export function assertSafeReverseFlowText(
  field: 'reason' | 'reference' | 'note',
  value: string,
): void {
  if (containsSensitiveFreeText(value)) {
    throw new BadRequestException(
      `${field} must not contain credential- or payment-bearing values`,
    );
  }
}

/**
 * Caller-supplied ids reflected into error messages get the same redaction as
 * the inventory module's unresolved-id 404s: error responses land in logs and
 * telemetry, so a PAN- or credential-valued id must echo back as [REDACTED],
 * never verbatim. Server-resolved ids are our own data and stay readable.
 */
export function safeErrorEntityId(id: string): string {
  return containsSensitiveFreeText(id) ? '[REDACTED]' : id;
}
