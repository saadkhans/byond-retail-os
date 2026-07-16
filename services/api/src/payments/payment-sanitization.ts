import { BadRequestException } from '@nestjs/common';
import { containsSensitiveValue } from '../common/sensitive-keys';

/**
 * Payment-domain sensitive-input guards. Every free-form string a payment
 * mutation persists or audits is an OPAQUE reference or operator note — a
 * provider ref, an idempotency key, a description, a failure/reconciliation
 * reason. None of them may ever carry credential- or payment-bearing content
 * (a raw PAN, a token/api-key/secret fragment, a credential URL, a CVV/PIN):
 * such material must never reach storage or the audit log in the first place
 * (AGENTS.md payments invariant). Audit-snapshot redaction is only a backstop.
 *
 * Same shared detection (common/sensitive-keys) and same controlled-400
 * pattern as checkout evidence refs and device metadata — checked BEFORE any
 * repository write.
 */

/** Throws 400 if any provided value carries credential-/payment-bearing content. */
export function assertSafePaymentStrings(
  fields: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && containsSensitiveValue(value)) {
      throw new BadRequestException(
        `${name} must be an opaque reference/note and must not contain ` +
          `credential- or payment-bearing values (no raw card numbers, ` +
          `CVV/PIN, tokens, API keys, secrets, or credential URLs). Secrets ` +
          `belong in a dedicated secret store, referenced by name; payment ` +
          `data must never be stored.`,
      );
    }
  }
}

export function assertSafeIdempotencyKey(key: string | undefined): void {
  if (key !== undefined && containsSensitiveValue(key)) {
    throw new BadRequestException(
      'idempotencyKey must be an opaque identifier and must not contain ' +
        'credential- or payment-bearing values',
    );
  }
}

/**
 * `instrumentLast4` is the ONLY card-derived field payments store, and it must
 * be EXACTLY four digits — never a fuller PAN fragment. The DB CHECK
 * (`^[0-9]{4}$`) backstops this; rejecting here returns a controlled 400.
 */
export function assertSafeLast4(last4: string | undefined): void {
  if (last4 !== undefined && !/^[0-9]{4}$/.test(last4)) {
    throw new BadRequestException(
      'instrumentLast4 must be exactly four digits (safe card metadata only; ' +
        'never a full or partial card number)',
    );
  }
}
