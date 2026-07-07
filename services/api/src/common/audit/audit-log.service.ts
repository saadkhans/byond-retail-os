import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const SYSTEM_ACTOR_EMAIL = 'system@byond.internal';

// Redaction rules applied recursively to before/after snapshots. Audit rows
// outlive normal data-retention paths, so sensitive material must never enter
// them. Keys are reduced to lowercase alphanumerics before comparison, so
// every separator style matches: api_key, access-token, access:token,
// refresh/token, credit_card_number, "Card Number", secret.key, ...
//
// Detection is exact-match PLUS suffix-match, so qualified aliases like
// apiToken, paymentToken, cardToken, clientSecret, creditCardNumber, and
// primary_account_number are caught without enumerating every prefix.
// For audit snapshots, conservative over-redaction of credential-shaped
// fields is acceptable; suffixes are chosen so common harmless fields
// (timespan, tokenized, description, ...) never match.
const REDACTED_EXACT = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'bearer',
  'bearertoken',
  'apikey',
  'authorization',
  'cardnumber',
  'creditcard',
  'creditcardnumber',
  'cvv',
  'cvc',
  // PAN variants stay exact-match: a generic "pan" suffix would catch
  // harmless fields like timespan.
  'pan',
  'cardpan',
  'primaryaccountnumber',
  'pin',
  'iban',
]);

// A normalized key ENDING in any of these is redacted: apitoken,
// paymenttoken, cardtoken, appsecret, webhooksecret, bankaccountnumber, ...
const REDACTED_SUFFIXES = [
  'token',
  'secret',
  'password',
  'apikey',
  'cardnumber',
  'accountnumber',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    REDACTED_EXACT.has(normalized) ||
    REDACTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Authenticated actor attribution for audited mutations. */
export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditEntry {
  tenantId: string | null;
  actorId?: string | null;
  actorEmail: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit record. Intentionally NOT fire-and-forget: if the audit
   * write fails, the calling state change must fail with it (fail closed).
   *
   * Pass the surrounding Prisma transaction client as `tx` so the audit row
   * commits or rolls back atomically with the mutation it describes —
   * repositories performing audited mutations must always do this.
   *
   * There are no update/delete methods on this service by design.
   */
  async record(
    entry: AuditEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: this.toJson(entry.before),
        after: this.toJson(entry.after),
        reason: entry.reason,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        requestId: entry.requestId,
      },
    });
  }

  private toJson(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return Prisma.JsonNull;
    }
    return this.redact(value) as Prisma.InputJsonValue;
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redact(val);
        }
      }
      return result;
    }
    return value;
  }
}
