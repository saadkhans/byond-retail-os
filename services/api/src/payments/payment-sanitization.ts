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

/**
 * A bare 3- or 4-digit numeric string (optionally space/dash grouped) is the
 * shape of an UNLABELED CVV/CVC (3–4 digits) or PIN (4 digits).
 * `containsSensitiveValue` only catches LABELED/Luhn-valid material, so a value
 * like "123" or "1 2 3 4" in instrumentBrand/instrumentWallet/description/notes
 * would otherwise persist. instrumentLast4 is the ONLY field allowed to be four
 * digits, and it is validated separately (assertSafeLast4) — it never flows
 * through here.
 */
function isBareCvvOrPin(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '');
  return /^\d{3,4}$/.test(compact);
}

/** Throws 400 if any provided value carries credential-/payment-bearing content. */
export function assertSafePaymentStrings(
  fields: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (containsSensitiveValue(value)) {
      throw new BadRequestException(
        `${name} must be an opaque reference/note and must not contain ` +
          `credential- or payment-bearing values (no raw card numbers, ` +
          `CVV/PIN, tokens, API keys, secrets, or credential URLs). Secrets ` +
          `belong in a dedicated secret store, referenced by name; payment ` +
          `data must never be stored.`,
      );
    }
    if (isBareCvvOrPin(value)) {
      throw new BadRequestException(
        `${name} looks like a bare CVV/PIN (3–4 digits) and must not be ` +
          `stored. Only instrumentLast4 may hold four digits.`,
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
